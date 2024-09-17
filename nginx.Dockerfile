# Use Nginx image
FROM nginx:latest

# Copy Nginx configuration
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
