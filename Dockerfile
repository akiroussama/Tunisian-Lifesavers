FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8098 DATA_FILE=/app/storage/db.json
COPY package.json server.js ./
COPY public ./public
COPY data/seed.json ./data/seed.json
RUN mkdir -p /app/storage && chown -R node:node /app/storage
USER node
EXPOSE 8098
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8098/api/health || exit 1
CMD ["node", "server.js"]
