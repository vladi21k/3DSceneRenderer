# Tooling image for offline asset generation (Blender, Node, Python image tools).
# The web app itself needs no build step; this image is only used by scripts in tools/.
FROM ubuntu:24.04

ARG BLENDER_VERSION=4.5.14
ARG BLENDER_SERIES=4.5
ARG NODE_VERSION=24.22.0
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git make \
      python3 python3-pip python3-numpy python3-scipy python3-pil \
      imagemagick ffmpeg \
      libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libxkbcommon-x11-0 \
      libsm6 libice6 libgl1 libegl1 libglu1-mesa libfontconfig1 libfreetype6 libdbus-1-3 \
      libwayland-client0 libwayland-cursor0 libwayland-egl1 libdecor-0-0 libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://download.blender.org/release/Blender${BLENDER_SERIES}/blender-${BLENDER_VERSION}-linux-x64.tar.xz \
      | tar -xJ -C /opt && ln -s /opt/blender-${BLENDER_VERSION}-linux-x64/blender /usr/local/bin/blender

RUN curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
      | tar -xJ -C /opt && for b in node npm npx; do ln -s /opt/node-v${NODE_VERSION}-linux-x64/bin/$b /usr/local/bin/$b; done

RUN npm install -g @gltf-transform/cli@4 && ln -sf /opt/node-v${NODE_VERSION}-linux-x64/bin/gltf-transform /usr/local/bin/gltf-transform

ENV HOME=/tmp
WORKDIR /work
