FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# data/ dir must contain stops.json and trips.json — build them before the image
# or mount the data/ directory as a volume and run refresh-gtfs inside the container first.
# Example: docker run --rm -v $(pwd)/data:/app/data --env-file .env tramtracker node scripts/refresh-gtfs.js

EXPOSE 3000

CMD ["node", "src/server.js"]
