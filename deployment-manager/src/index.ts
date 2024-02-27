import Koa from "koa";
import Router from "koa-router";

import logger from "koa-logger";
import json from "koa-json";
import bodyParser from "koa-bodyparser";
import koaBody from "koa-body";

import { z } from "zod";
import * as k8s from '@kubernetes/client-node';

const app = new Koa();
const router = new Router();

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);

const registryUrl = process.env.REGISTRY_URL || 'http://localhost:5000'

async function getConfigFromDockerfile(repository: string, tag: string) {
  const manifestResponse = await fetch(`${registryUrl}/v2/${repository}/manifests/${tag}`, {
    headers: {
      Accept: 'application/vnd.docker.distribution.manifest.v2+json'
    }
  })
  const digest = (await manifestResponse.json()).config.digest
  const blobResponse = await fetch(`${registryUrl}/v2/${repository}/blobs/${digest}`, {
    headers: {
      Accept: 'application/vnd.docker.distribution.manifest.v2+json'
    }
  })
  const config = (await blobResponse.json()).config
  return {
    labels: config.Labels as Record<string, string>,
    exposedPorts: Object.keys(config.ExposedPorts).map(exposeString => ({
      port: parseInt(exposeString.split('/')[0]),
      protocol: exposeString.split('/')[1]
    })),
  }
}

async function upsertDeployment(repository: string, tag: string, config: Awaited<ReturnType<typeof getConfigFromDockerfile>>) {
  const deploymentListResp = await k8sAppsApi.listNamespacedDeployment('default')
  const deployment = deploymentListResp.body.items.find(deployment => deployment.metadata?.name === `${repository}-${tag}`)
  if (!deployment) {
    const deployment: k8s.V1Deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: `${repository}-${tag}`,
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: `${repository}-${tag}`
          }
        },
        template: {
          metadata: {
            labels: {
              app: `${repository}-${tag}`
            }
          },
          spec: {
            containers: [
              {
                name: repository,
                image: `localhost:5000/${repository}:${tag}`,
                imagePullPolicy: 'Always',
                ports: config.labels?.PORT ? [{
                  containerPort: parseInt(config.labels.PORT)
                }] : [],
              }
            ],
            imagePullSecrets: [{
              name: 'local-registry-hosting'
            }]
          }
        }
      }
    }
    await k8sAppsApi.createNamespacedDeployment('default', deployment)
  } else {
    await k8sAppsApi.patchNamespacedDeployment(`${repository}-${tag}`, 'default', [
      {
        op: 'replace',
        path: '/spec/template/spec/containers/0/ports',
        value: config.labels?.PORT ? [{
          containerPort: parseInt(config.labels.PORT)
        }] : [],
      },
    ], undefined, undefined, undefined, undefined, undefined, { headers: { 'content-type': 'application/json-patch+json' }})

    // restart deployment
    await k8sAppsApi.patchNamespacedDeployment(
      `${repository}-${tag}`,
      'default',
      [{ op: 'replace', path: '/spec/replicas', value: 0 }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'content-type': 'application/json-patch+json' } }
    );
      
    await k8sAppsApi.patchNamespacedDeployment(
      `${repository}-${tag}`,
      'default',
      [{ op: 'replace', path: '/spec/replicas', value: 1 }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'content-type': 'application/json-patch+json' } }
    );

  }
}

async function upsertService(repository: string, tag: string, config: Awaited<ReturnType<typeof getConfigFromDockerfile>>) {
  const serviceListResp = await k8sCoreApi.listNamespacedService('default')
  const service = serviceListResp.body.items.find(service => service.metadata?.name === `${repository}-${tag}`)
  if (!service) {
    const service: k8s.V1Service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: `${repository}-${tag}`,
      },
      spec: {
        selector: {
          app: `${repository}-${tag}`
        },
        ports: config.labels?.PORT ? [{
          protocol: "TCP",
          port: parseInt(config.labels.PORT),
          targetPort: parseInt(config.labels.PORT)
        }] : [],
        type: "ClusterIP"
      }
    }
    await k8sCoreApi.createNamespacedService('default', service)
  } else {
    await k8sCoreApi.patchNamespacedService(`${repository}-${tag}`, 'default', [
      {
        op: 'replace',
        path: '/spec/ports',
        value: config.labels?.PORT ? [{
          protocol: "TCP",
          port: parseInt(config.labels.PORT),
          targetPort: parseInt(config.labels.PORT)
        }] : [],
      },
    ], undefined, undefined, undefined, undefined, undefined, { headers: { 'content-type': 'application/json-patch+json' }})
  
  }
}


const dockerEventBody = z.object({
  events: z.array(
    z.union([
      z.object({
        id: z.string(),
        timestamp: z.string(),
        action: z.literal('pull'),
        target: z.object({
          repository: z.string(),
          tag: z.string(),
        })
      }),
      z.object({
        id: z.string(),
        timestamp: z.string(),
        action: z.literal('push'),
        target: z.object({
          repository: z.string(),
          tag: z.string(),
        })
      })
    ]),
  )
});

router.post("/event", koaBody({ multipart: true }), async (ctx, next) => {
  try {
    const { events } = dockerEventBody.parse(ctx.request.body);
    for (const event of events) {
      if (event.action === 'push') {
        console.log(`Pushed to ${event.target.repository}:${event.target.tag}`);
        const config = await getConfigFromDockerfile(event.target.repository, event.target.tag)
        await upsertDeployment(event.target.repository, event.target.tag, config)
        await upsertService(event.target.repository, event.target.tag, config)
      }
    }
  } catch (e) {
    console.error(e);
  }

  ctx.status = 200
  await next()
});

// Middlewares
app.use(json());
app.use(logger());
app.use(bodyParser({ extendTypes: {
  json: ['application/vnd.docker.distribution.events.v1+json']
}
}));

// Routes
app.use(router.routes()).use(router.allowedMethods());

app.listen(3030, () => {
  console.log("Koa started");
});
