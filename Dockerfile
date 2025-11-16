FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./
COPY migrations ./migrations

RUN chmod +x docker-entrypoint.sh && \
    addgroup -S nodegrp && adduser -S nodeusr -G nodegrp
USER nodeusr

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'require("http").get({host:"localhost",port:3000,path:"/api/v1/health"},r=>{if(r.statusCode!==200)process.exit(1);}).on("error",()=>process.exit(1))'

CMD ["./docker-entrypoint.sh"]
