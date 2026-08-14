FROM node:22.18.0-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app
COPY dist ./dist

USER node
EXPOSE 8080

CMD ["node", "dist/server.js"]
