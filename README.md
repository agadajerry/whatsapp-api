const qrcode = require('qrcode-terminal');
const { GroupChat } = require('whatsapp-web.js');
const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: '../'
    }),
    puppeteer: {
        headless: false,
        args: ['--no-sandbox'],
        browserWSEndpoint: process.env.BROWSER_URL,
    },
});

client.on('qr', (qr) => {
    qrcode.generate(qr, {small: true});
});

client.on('ready', async () => {
    console.log('Client is ready!');

});

client.on('message', async (message) => {
   console.log(message)
})

client.initialize().catch(console.error);



<!-- Docker file -->

FROM  node:17.0.0-alpine

RUN apk add chromium

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

EXPOSE 3001




<!--docker-compose-file  -->

version: "3"

services:
  node:
    build:
      context: .
      dockerfile: Dockerfile
    tty: true
    working_dir: /home/node
    ports:
      - 3001:3001
    volumes:
      - .:/home/node
    networks:
      - whats-app-bot
    environment:
      BROWSER_URL: 'ws://browser:3000'
    depends_on:
      - browser
      
  mongodb:
      image: mongo:4.2.1-bionic
      ports:
        - '27017:27017'
      volumes:
        - ./db-data-mongodb:/data/db
      networks:
        - whats-app-bot

  browser:
    image: browserless/chrome:latest
    hostname: browser
    volumes:
      - ./.wwebjs_auth/session/:/usr/src/app/user-data-dir
    environment:
      CONNECTION_TIMEOUT: -1
      KEEP_ALIVE: 'true'
      WORKSPACE_EXPIRE_DAYS: 1
      ENABLE_CORS: 'true'
      CHROME_REFRESH_TIME: 86400000
      DEFAULT_BLOCK_ADS: 'true'
      FUNCTION_ENABLE_INCOGNITO_MODE: 'true'
      ENABLE_XVBF: 'true'
      CHROME_PATH: '/usr/bin/google-chrome'
      USE_CHROME_STABLE: 'true'
      NODE_ENV: 'production'
      MAX_CONCURRENT_SESSIONS: 1
      DEFAULT_USER_DATA_DIR: /usr/src/app/user-data-dir
    ports:
      - 3000:3000
    networks:
        - whats-app-bot


networks:
  whats-app-bot:
    driver: bridge