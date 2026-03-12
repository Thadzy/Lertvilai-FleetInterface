# Test Commands

**Fleet Gateway:** `http://localhost:8080/graphql`
**VRP Server:** `http://10.61.6.65:18080`

---

## VRP Server

### POST /solve_alias

```bash
curl -X POST http://10.61.6.65:18080/solve_alias \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "graph_name=fibo_6fl" \
  -d "num_vehicles=1" \
  -d "pickups_deliveries=[[\"S3C1L3\",\"S1C2L2\"],[\"S2C3L3\",\"S4C1L3\"]]" \
  -d "robot_locations=[\"Q119\"]" \
  -d "vehicle_capacity=1"
```

```json
{"data":{"paths":[["Q119","S3C1L3","S1C2L2","S2C3L3","S2C1L3","__depot__"]]},"error":null,"success":true}
```

---

## Fleet Gateway — Queries

### Get all robots

```graphql
query {
  robots {
    name
    connectionStatus
    lastActionStatus
    mobileBaseState {
      tag { qrId timestamp }
      pose { x y a timestamp }
    }
    currentJob {
      uuid status operation
      targetNode { id alias nodeType }
    }
    jobQueue {
      uuid status operation
      targetNode { alias }
    }
    cells {
      height
      holding { uuid status }
    }
  }
}
```

### Get single robot

```graphql
query {
  robot(name: "LOCALBOT") {
    name
    connectionStatus
    lastActionStatus
    piggybackState {
      lift turntable slide hookLeft hookRight timestamp
    }
    currentJob {
      uuid status operation
      targetNode { id alias nodeType }
    }
    jobQueue {
      uuid status operation
      targetNode { alias }
    }
    cells {
      height
      holding { uuid status }
    }
  }
}
```

### Get all jobs

```graphql
query {
  jobs {
    uuid
    status
    operation
    targetNode { id alias nodeType }
    handlingRobot { name }
  }
}
```

### Get single job

```graphql
query {
  job(uuid: "00000000-0000-0000-0000-000000000000") {
    uuid
    status
    operation
    targetNode { id alias nodeType x y }
    handlingRobot { name connectionStatus lastActionStatus }
    request { uuid status }
  }
}
```

### Get all requests

```graphql
query {
  requests {
    uuid
    status
    pickup { uuid status operation targetNode { alias } }
    delivery { uuid status operation targetNode { alias } }
    handlingRobot { name }
  }
}
```

### Get single request

```graphql
query {
  request(uuid: "00000000-0000-0000-0000-000000000000") {
    uuid
    status
    pickup { uuid status operation targetNode { alias nodeType } }
    delivery { uuid status operation targetNode { alias nodeType } }
    handlingRobot { name connectionStatus lastActionStatus }
  }
}
```

---

## Fleet Gateway — Mutations

### sendPickupOrder

```graphql
mutation {
  sendPickupOrder(pickupOrder: {
    robotName: "LOCALBOT"
    targetNodeAlias: "S3C1L3"
  }) {
    success
    message
    job { uuid status operation targetNode { alias } }
  }
}
```

### sendDeliveryOrder

```graphql
mutation {
  sendDeliveryOrder(deliveryOrder: {
    robotName: "LOCALBOT"
    cellLevel: 0
    targetNodeAlias: "S1C2L2"
  }) {
    success
    message
    job { uuid status operation targetNode { alias } }
  }
}
```

### sendTravelOrder

```graphql
mutation {
  sendTravelOrder(travelOrder: {
    robotName: "LOCALBOT"
    targetNodeAlias: "Q119"
  }) {
    success
    message
    job { uuid status operation targetNode { alias } }
  }
}
```

### sendRequestOrder

```graphql
mutation {
  sendRequestOrder(requestOrder: {
    robotName: "LOCALBOT"
    requestAlias: {
      pickupNodeAlias: "S3C1L3"
      deliveryNodeAlias: "S1C2L2"
    }
  }) {
    success
    message
    request {
      uuid status
      pickup { uuid status targetNode { alias } }
      delivery { uuid status targetNode { alias } }
    }
  }
}
```

### sendWarehouseOrder

```graphql
mutation SendWarehouseOrder($warehouseOrder: WarehouseOrderInput!) {
  sendWarehouseOrder(warehouseOrder: $warehouseOrder) {
    success
    message
    requests {
      uuid
      status
      pickup { uuid status targetNode { alias } }
      delivery { uuid status targetNode { alias } }
      handlingRobot { name }
    }
  }
}
```

```json
{
  "warehouseOrder": {
    "requestAliases": [
      { "pickupNodeAlias": "S3C1L3", "deliveryNodeAlias": "S1C2L2" },
      { "pickupNodeAlias": "S2C3L3", "deliveryNodeAlias": "S4C1L3" }
    ],
    "assignments": [
      {
        "robotName": "LOCALBOT",
        "routeNodeAliases": ["Q119", "S3C1L3", "S1C2L2", "S2C3L3", "S4C1L3", "__depot__"]
      }
    ]
  }
}
```

```json
{
  "data": {
    "sendWarehouseOrder": {
      "requests": [
        {
          "uuid": "1b011113-e1fb-4af6-a932-b5521f61286f",
          "status": "QUEUING",
          "pickup": { "uuid": "...", "status": "QUEUING", "targetNode": { "alias": "S3C1L3" } },
          "delivery": { "uuid": "...", "status": "QUEUING", "targetNode": { "alias": "S1C2L2" } },
          "handlingRobot": { "name": "LOCALBOT" }
        },
        {
          "uuid": "480ef29b-9aed-4731-a4cb-ba4f58cfbaa6",
          "status": "QUEUING",
          "pickup": { "uuid": "...", "status": "QUEUING", "targetNode": { "alias": "S2C3L3" } },
          "delivery": { "uuid": "...", "status": "QUEUING", "targetNode": { "alias": "S4C1L3" } },
          "handlingRobot": { "name": "LOCALBOT" }
        }
      ]
    }
  }
}
```

---

## Fleet Gateway — Cancellation

### cancelCurrentJob

```graphql
mutation {
  cancelCurrentJob(robotName: "LOCALBOT") {
    uuid
    status
    operation
    targetNode { alias }
  }
}
```

### cancelJob

```graphql
mutation {
  cancelJob(uuid: "00000000-0000-0000-0000-000000000000") {
    uuid
    status
  }
}
```

### cancelJobs

```graphql
mutation {
  cancelJobs(uuids: [
    "00000000-0000-0000-0000-000000000000",
    "11111111-1111-1111-1111-111111111111"
  ]) {
    uuid
    status
  }
}
```

### cancelRequest

```graphql
mutation {
  cancelRequest(uuid: "00000000-0000-0000-0000-000000000000") {
    uuid
    status
    pickup { uuid status }
    delivery { uuid status }
  }
}
```

### cancelRequests

```graphql
mutation {
  cancelRequests(uuids: [
    "00000000-0000-0000-0000-000000000000"
  ]) {
    uuid
    status
    pickup { uuid status }
    delivery { uuid status }
  }
}
```

---

## Fleet Gateway — Recovery

### clearRobotError

Resets the robot from `ERROR` to `IDLE` and resumes queue processing.

```graphql
mutation {
  clearRobotError(robotName: "LOCALBOT")
}
```

### freeRobotCell

Manually clears a cell when cargo was physically removed but the software still shows it as occupied.

```graphql
mutation {
  freeRobotCell(robotCell: { robotName: "LOCALBOT", cellIndex: 0 }) {
    height
    holding { uuid status }
  }
}
```
