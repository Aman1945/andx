# One image for all five services; each container runs a different entrypoint.
# Node 24 runs TypeScript directly (type stripping), so there is no build step.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production NODE_NO_WARNINGS=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY shared ./shared
COPY db ./db
COPY services ./services
COPY tests ./tests
COPY scripts ./scripts
COPY web2-kit/ai ./web2-kit/ai
