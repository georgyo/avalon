FROM node:current-alpine AS yarninstall

RUN mkdir /app && chown node:node /app

WORKDIR /app
USER node

# Dockerfile is really bad at copying directories, 
# so we must add files from each directory individually. 
COPY --chown=node:node yarn.lock .yarnrc.yml package.json ./
COPY --chown=node:node .yarn/ .yarn/
COPY --chown=node:node server/package.json server/
COPY --chown=node:node client/package.json client/

RUN yarn install --immutable --inline-builds \
  && rm -rf .yarn/cache


FROM node:current-alpine 

WORKDIR /app
USER node

COPY --from=yarninstall --chown=node:node /app/ ./

COPY --chown=node:node  ./ ./

RUN yarn build

CMD yarn workspace @avalon/server serve
