# POC Deploy via docker push

## Idea

Deploy docker images only via docker push.

## Setup

- Create test cluster via kind: `./create-kind.sh`
- Start deployment-manager: `docker-compose up --build`
- Build test image: `docker build ./nginx-test -t localhost:5000/nginx`
- Push test image to registry: `docker push localhost:5000/nginx`
