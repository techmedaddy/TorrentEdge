# src/server/Dockerfile

# Use Node.js LTS version for better security and performance
FROM node:18-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

# Set working directory inside the container
WORKDIR /usr/src/app

# Copy backend package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy backend application code
COPY . .

# Expose the port the app runs on (synced with docker-compose)
EXPOSE 3029

# Define the command to run the backend server
CMD ["node", "server.js"]
