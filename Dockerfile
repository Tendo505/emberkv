FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin bin
COPY src src
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 6379
# node is PID 1 here; emberkv handles SIGTERM itself and saves the snapshot before exiting
ENTRYPOINT ["node", "bin/emberkv.js", "--host", "0.0.0.0", "--dir", "/data"]
