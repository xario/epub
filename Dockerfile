FROM arm64v8/node:16-alpine3.14
WORKDIR /epub
ADD src /epub
RUN mkdir -p htdocs/pics/books
RUN npm install
CMD ["node", "epub.js"]
