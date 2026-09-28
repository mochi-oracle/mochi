FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig*.json ./
COPY packages ./packages
COPY services ./services
RUN bun install --frozen-lockfile --ignore-scripts
COPY web/site ./web/site
WORKDIR /app/web/site
RUN bun install --frozen-lockfile --ignore-scripts && bun run build

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/claims ./services/claims
COPY --from=build /app/services/juror/src/phala-dcap.ts ./services/juror/src/phala-dcap.ts
COPY --from=build /app/web/site/dist ./web/site/dist
COPY web/server.ts web/claims-proxy.ts web/deployment-config.ts ./web/
ENV HOST=0.0.0.0 PORT=8080
USER bun
EXPOSE 8080
CMD ["bun", "web/server.ts"]
