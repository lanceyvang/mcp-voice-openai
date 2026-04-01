FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 8767
ENV PORT=8767
CMD ["node", "server.js"]
