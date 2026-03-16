FROM mcr.microsoft.com/playwright:v1.58.0-noble

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY scripts ./scripts

ENV NODE_ENV=production \
    AUTO_REFRESH_ENABLED=1 \
    AUTO_REFRESH_MIN_PER_DAY=2 \
    AUTO_REFRESH_MAX_PER_DAY=3
VOLUME ["/data"]
EXPOSE 8080

CMD ["npm", "run", "panel"]
