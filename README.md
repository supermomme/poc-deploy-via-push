# POC Deploy via docker push

## How does it work?

A push to a private registry should trigger a deployment. This is done using the notification channel from the distribution-registry. It acts like a webhook when events such as a push are triggered in the registry. The deployment-manager™ receives the event/webhook and triggers a deployment to kubernetes, knative or similar.

TLDR: Deploy docker images only via docker push.

## Setup

- Create test cluster via kind: `./create-kind.sh`
- Start deployment-manager: `docker-compose up --build`
- Build test image: `docker build ./nginx-test -t localhost:5000/nginx`
- Push test image to registry: `docker push localhost:5000/nginx`

## Ports

- registry: `5000`
- registry-ui: `5050`
- deployment-manager (api): `3030`
