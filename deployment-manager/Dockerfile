FROM node:18.14.2-alpine3.16 AS workspace-base

WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY . ./

CMD [ "npm", "start"]