FROM node:22-alpine

WORKDIR /app
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

VOLUME /data
EXPOSE 8080

CMD ["node", "server/server.js"]
