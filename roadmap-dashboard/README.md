# Roadmap Agent Dashboard

A web-based dashboard for monitoring and controlling the roadmap-agent.sh script.

## Features

- **Agent Control**: Start/stop the roadmap agent with configurable options
- **Real-time Logs**: Stream agent output via Server-Sent Events
- **Roadmap Viewer**: View ROADMAP.md and ROADMAP_PROMPT.md files
- **Task Status**: Visualize task progress with statistics and task list
- **Log History**: Browse and view historical log files

## Installation

Install dependencies:

```bash
npm install
```

## Usage

Start the dashboard server:

```bash
npm run roadmap-dashboard
```

Or directly:

```bash
node roadmap-dashboard/server.js
```

Then open your browser to:

```
http://localhost:3001
```

## API Endpoints

- `GET /api/status` - Get agent status and task statistics
- `GET /api/roadmap` - Get ROADMAP.md content
- `GET /api/prompt` - Get ROADMAP_PROMPT.md content
- `GET /api/tasks` - Get parsed task list
- `GET /api/logs` - List available log files
- `GET /api/logs/:filename` - Get specific log file content
- `GET /api/stream` - Server-Sent Events stream for real-time logs
- `POST /api/agent/start` - Start the agent
- `POST /api/agent/stop` - Stop the agent

## Configuration

The server runs on port 3001 by default. Set the `PORT` environment variable to change:

```bash
PORT=8080 node roadmap-dashboard/server.js
```
