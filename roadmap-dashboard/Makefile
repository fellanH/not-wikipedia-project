.PHONY: all build run stop logs clean test health dev

IMAGE_NAME := roadmap-dashboard
CONTAINER_NAME := roadmap-dashboard
PORT := 3001

all: build

build:
	docker build -t $(IMAGE_NAME) .

run: stop
	docker run -d \
		--name $(CONTAINER_NAME) \
		-p $(PORT):3001 \
		-v $(PWD)/../roadmap-logs:/app/logs:ro \
		-v $(PWD)/../ROADMAP.md:/app/ROADMAP.md:ro \
		-v $(PWD)/../ROADMAP_PROMPT.md:/app/ROADMAP_PROMPT.md:ro \
		-e NODE_ENV=production \
		-e ALLOWED_ORIGINS=http://localhost:$(PORT) \
		--restart unless-stopped \
		$(IMAGE_NAME)

stop:
	-docker stop $(CONTAINER_NAME) 2>/dev/null || true
	-docker rm $(CONTAINER_NAME) 2>/dev/null || true

logs:
	docker logs -f $(CONTAINER_NAME)

health:
	@curl -sf http://localhost:$(PORT)/api/health | jq . || echo "Health check failed"

clean: stop
	-docker rmi $(IMAGE_NAME) 2>/dev/null || true

dev:
	NODE_ENV=development node server.js

test:
	@echo "Running health check..."
	@curl -sf http://localhost:$(PORT)/api/health > /dev/null && echo "OK" || echo "FAILED"
