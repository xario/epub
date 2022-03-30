FROM mhart/alpine-node:16.4.2
WORKDIR /epub
ADD src /epub
RUN npm install
CMD ["node", "epub.js"]