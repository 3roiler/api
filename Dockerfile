FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=localhost
ENV PORT=3000
ENV API_PREFIX=/api

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./
COPY migrations ./migrations

RUN mkdir -p /app/.certs && \
    chmod +x docker-entrypoint.sh && \
    addgroup -S nodegrp && adduser -S nodeusr -G nodegrp && \
    chown -R nodeusr:nodegrp /app/.certs

USER nodeusr

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'require("http").get({host:"${HOST}",port:${PORT},path:"${API_PREFIX}/health"},r=>{if(r.statusCode!==200)process.exit(1);}).on("error",()=>process.exit(1))'

CMD ["./docker-entrypoint.sh"]
