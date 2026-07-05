FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm run install:all
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
