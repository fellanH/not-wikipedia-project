FROM node:20-alpine

RUN apk add --no-cache bash procps

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

COPY package*.json ./

RUN npm ci --only=production && npm cache clean --force

COPY --chown=nodejs:nodejs . .

RUN mkdir -p /app/logs && chown -R nodejs:nodejs /app/logs

USER nodejs

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

CMD ["node", "server.js"]
