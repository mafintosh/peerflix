FROM node:10-jessie-slim

COPY index.js /app/index.js
COPY app.js /app/app.js
COPY package.json /app/package.json

WORKDIR /app
RUN npm install
EXPOSE 8888
ENTRYPOINT ["node", "app.js"]
