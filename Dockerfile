FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY lib/ ./lib/
COPY jobs/ ./jobs/
COPY scripts/ ./scripts/

# Two Cloud Run Job resources point at this one image with different --command/--args
# (weekly-setup vs status-poller) — avoids duplicate Dockerfiles for two thin jobs, same
# "one image, parameterize" philosophy row_newsletter_automation uses for its 9 countries.
ENTRYPOINT ["node"]
CMD ["jobs/weekly-setup.js"]
