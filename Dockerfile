FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
COPY test ./test
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
RUN addgroup -S gridwise && adduser -S gridwise -G gridwise
USER gridwise
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "src/app.js"]
