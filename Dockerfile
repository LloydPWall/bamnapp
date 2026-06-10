FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm install --omit=dev

# Copy app files
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
