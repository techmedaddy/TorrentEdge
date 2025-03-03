# src/server/Dockerfile

# Use Node.js LTS version for better security and performance
FROM node:18-alpine

# Set working directory inside the container
WORKDIR /usr/src/app

# Copy backend package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy backend application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run the backend server
CMD ["node", "server.js"]
