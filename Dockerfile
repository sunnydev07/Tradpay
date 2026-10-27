FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application files
COPY server/ ./server/
COPY public/ ./public/
# Runtime data is created at startup; never bake local tokens/PINs into an image.
RUN mkdir -p /app/data

# Environment
ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

# Start server
CMD ["node", "server/index.js"]
