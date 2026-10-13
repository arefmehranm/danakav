# Static-only image for the danakav.ir demo (no backend).
#
# Build after `build-demo-zip.mjs` has produced ../build-demo/dist:
#   docker build -f frontend/scripts/demo-standalone/Dockerfile frontend/scripts/demo-standalone
FROM nginx:stable-alpine

RUN echo "types { application/javascript js mjs; }" > /etc/nginx/conf.d/mjs.conf \
    && rm -f /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/danakav-demo.conf
COPY dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
