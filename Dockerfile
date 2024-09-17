# Use Node.js image
FROM node:14

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Expose port and start server
EXPOSE 3000
CMD ["node", "src/server/server.js"]
