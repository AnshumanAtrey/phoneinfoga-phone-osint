FROM apify/actor-python:3.13

ARG PHONEINFOGA_VERSION=v2.11.0

RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
        x86_64) PI_ARCH=x86_64 ;; \
        aarch64|arm64) PI_ARCH=arm64 ;; \
        *) echo "Unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/sundowndev/phoneinfoga/releases/download/${PHONEINFOGA_VERSION}/phoneinfoga_Linux_${PI_ARCH}.tar.gz"; \
    echo "Downloading $url"; \
    curl -fsSL "$url" -o /tmp/phoneinfoga.tgz; \
    tar -xzf /tmp/phoneinfoga.tgz -C /usr/local/bin phoneinfoga; \
    chmod +x /usr/local/bin/phoneinfoga; \
    rm /tmp/phoneinfoga.tgz; \
    /usr/local/bin/phoneinfoga version

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./

CMD ["python3", "-m", "src.main"]
