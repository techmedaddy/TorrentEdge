# TorrentEdge

**TorrentEdge** is a highly scalable, distributed BitTorrent client built using **Node.js**, **Nginx**, and **Apache Kafka**. The project integrates real-time event streaming, load balancing, and distributed systems architecture, showcasing advanced backend and cloud infrastructure concept.


![WhatsApp Image 2024-10-17 at 22 13 59_a93cdfdb](https://github.com/user-attachments/assets/5c940e02-31b8-489c-b3ba-b11c222a8914)

## 🛠️🖥️ System Design 

![WhatsApp Image 2025-04-01 at 14 04 38_6c199595](https://github.com/user-attachments/assets/10007743-a98e-43ce-b951-8531a5b83cff)




### Key Features:
- **Peer-to-Peer Networking**: Efficient torrent download and upload functionality.
- **Real-Time Progress Updates**: Users receive live status and progress of torrents.
- **Event-Driven Architecture**: Decouples core torrenting logic from API and WebSocket servers using Kafka for real-time data processing and message queuing.
- **Scalable & Resilient**: Kafka ensures scalable and resilient communication between system components.
- **Nginx Reverse Proxy**: Manages static content delivery, API requests, and WebSocket connections.

### Tech Stack:
- **Node.js**: Core backend for handling torrenting logic and APIs.
- **Apache Kafka**: Event streaming and message queuing.
- **Nginx**: Reverse proxy for API and WebSocket handling.
- **Docker & Docker Compose**: Containerization of all services for easy deployment.


## Features

- **BitTorrent Client**: Manage torrent files, download, and upload torrents.
- **Real-Time Updates**: Notifications and updates using WebSocket and Kafka.
- **API Endpoints**: RESTful APIs for managing torrents, users, and statistics.
- **Frontend**: React-based user interface for interacting with the torrent client.
- **Deployment**: Dockerized setup for easy deployment with Nginx as a reverse proxy.


# BitTorrent Client Project Structure

The project follows a well-organized directory structure that separates core functionalities, configurations, and services for ease of development, maintenance, and scalability.

```bash
bittorrent-client/
│
├── src/
│   ├── client/               # Core BitTorrent client logic
│   │   ├── torrentManager.js  # Manages torrents (download, upload)
│   │   ├── peer.js            # Peer communication logic
│   │   ├── tracker.js         # Interaction with torrent tracker
│   │   ├── pieceManager.js    # Manages torrent file pieces
│   │   ├── kafkaProducer.js   # Produces events to Kafka topics
│   │   └── kafkaConsumer.js   # Consumes events from Kafka topics
│   │
│   ├── api/                  # API endpoints
│   │   ├── torrentController.js  # Controller to expose torrent API
│   │   └── kafkaController.js    # API for Kafka event monitoring
│   │
│   ├── server/               # Main server logic
│   │   └── server.js          # Node.js server handling API and WebSockets
│
├── kafka/                    # Kafka configuration and scripts
│   ├── topics/                # Kafka topics configuration
│   ├── producer/              # Producer scripts
│   └── consumer/              # Consumer scripts
│
├── nginx/                    # Nginx configuration
│   └── default.conf           # Nginx reverse proxy configuration
│
├── web/                      # Frontend React dashboard
│   ├── public/
│   └── src/
│       ├── components/        # React components (torrent status, progress)
│       └── App.js             # Main React entry point
│
├── tests/                    # Unit and integration tests
│   └── torrent.test.js
│
├── Dockerfile                # Dockerfile for Node.js
├── nginx.Dockerfile          # Dockerfile for Nginx
├── docker-compose.yml        # Docker Compose file for all services (Nginx, Node.js, Kafka)
├── .env                      # Environment variables
├── package.json              # Node.js dependencies
└── README.md                 # Project documentation
