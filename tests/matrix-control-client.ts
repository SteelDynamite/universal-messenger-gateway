type MatrixSyncResponse = {
  rooms?: { join?: Record<string, unknown>; invite?: Record<string, unknown> };
};

type MatrixWhoamiResponse = {
  user_id: string;
  device_id?: string;
};

type MatrixLoginResponse = MatrixWhoamiResponse & {
  access_token: string;
};

export class MatrixControlClient {
  constructor(
    private readonly homeserverUrl: string,
    readonly accessToken: string,
  ) {}

  async getUserId(): Promise<string> {
    return (await this.getWhoAmI()).user_id;
  }

  async getWhoAmI(): Promise<MatrixWhoamiResponse> {
    return await this.request<MatrixWhoamiResponse>("GET", "/account/whoami");
  }

  async createRoom(content: unknown): Promise<string> {
    const response = await this.request<{ room_id: string }>(
      "POST",
      "/createRoom",
      content,
    );
    return response.room_id;
  }

  async sendMessage(roomId: string, content: unknown): Promise<string> {
    const response = await this.request<{ event_id: string }>(
      "PUT",
      `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${Date.now()}-${Math.random().toString(16).slice(2)}`,
      content,
    );
    return response.event_id;
  }

  async sendStateEvent(
    roomId: string,
    type: string,
    stateKey: string,
    content: unknown,
  ): Promise<string> {
    const response = await this.request<{ event_id: string }>(
      "PUT",
      `/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
      content,
    );
    return response.event_id;
  }

  async getEvent(
    roomId: string,
    eventId: string,
  ): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>(
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    );
  }

  async leaveRoom(roomId: string, reason: string): Promise<void> {
    await this.request("POST", `/rooms/${encodeURIComponent(roomId)}/leave`, {
      reason,
    });
  }

  async syncNow(): Promise<MatrixSyncResponse> {
    return await this.request<MatrixSyncResponse>("GET", "/sync?timeout=0");
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(
      `${this.homeserverUrl}/_matrix/client/v3${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok) {
      throw new Error(`Matrix ${method} ${path} failed: ${response.status}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

export async function passwordLogin(
  homeserverUrl: string,
  userId: string,
  password: string,
  deviceName: string,
): Promise<MatrixControlClient & { deviceId?: string }> {
  const response = await fetch(`${homeserverUrl}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      user: userId,
      password,
      initial_device_display_name: deviceName,
    }),
  });
  if (!response.ok) {
    throw new Error(`Matrix password login failed: ${response.status}`);
  }
  const login = (await response.json()) as MatrixLoginResponse;
  return Object.assign(
    new MatrixControlClient(homeserverUrl, login.access_token),
    {
      deviceId: login.device_id,
    },
  );
}
