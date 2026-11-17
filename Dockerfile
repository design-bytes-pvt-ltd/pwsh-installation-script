FROM ubuntu:24.04
ARG TARGETARCH
ARG PWSH_VERSION=7.4.6
ENV DEBIAN_FRONTEND=noninteractive TERM=xterm-256color

# curl: required by install.ps1 on Linux; zstd: used by Ollama's install.sh; libicu: pwsh runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl zstd libicu74 less \
 && rm -rf /var/lib/apt/lists/*

# PowerShell from the official release tarball (works on both amd64 and arm64)
RUN case "$TARGETARCH" in amd64) a=x64 ;; arm64) a=arm64 ;; *) echo "unsupported arch: $TARGETARCH"; exit 1 ;; esac \
 && mkdir -p /opt/microsoft/powershell/7 \
 && curl -fsSL "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-${a}.tar.gz" \
    | tar -xz -C /opt/microsoft/powershell/7 \
 && chmod +x /opt/microsoft/powershell/7/pwsh \
 && ln -s /opt/microsoft/powershell/7/pwsh /usr/bin/pwsh

WORKDIR /workspace
CMD ["pwsh", "./install.ps1"]
