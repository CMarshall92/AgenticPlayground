FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY README.md ./README.md
COPY .env.preview ./.env.preview

EXPOSE 3000

CMD ["npm", "run", "dashboard"]