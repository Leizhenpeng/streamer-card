FROM node:20-alpine

LABEL authors="ygh3279799773"

RUN sed -i 's#https?://dl-cdn.alpinelinux.org/alpine#https://mirrors.tuna.tsinghua.edu.cn/alpine#g' /etc/apk/repositories

RUN apk update && apk add chromium

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package*.json ./

RUN yarn install
RUN npm config set registry http://mirrors.cloud.tencent.com/npm/
RUN npm install -g typescript ts-node

COPY . .

WORKDIR /app

EXPOSE 3003

CMD [ "ts-node", "src/index.ts" ]