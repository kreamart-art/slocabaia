# The House of Slocabaia: one Node process serves the site, the member API and the dashboard.
# Coolify: mount a persistent volume on /data and set the variables from .env.example
# (at least SITE_URL, ADMIN_PASSWORD_HASH, RESEND_API_KEY, MAIL_FROM).
FROM node:24-alpine
# ffmpeg turns a hero video uploaded in the dashboard into the 1080p and 720p web versions
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TRUST_PROXY=1
COPY package.json ./
COPY server ./server
COPY admin ./admin
COPY img ./img
COPY index.html ./
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/index.js"]
