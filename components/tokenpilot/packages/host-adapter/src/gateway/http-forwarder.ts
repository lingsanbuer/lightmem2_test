/* eslint-disable @typescript-eslint/no-explicit-any */
import { Readable } from "node:stream";
import type {
  HostGatewayForwarder,
  HostGatewayHttpResponse,
  HostGatewayStreamResponse,
  HostGatewayUpstreamConfig,
} from "../contracts/gateway-runtime.js";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveAuthorization(
  upstream: HostGatewayUpstreamConfig,
  inboundAuthorization?: string,
): string | undefined {
  if (upstream.apiKey) return `Bearer ${upstream.apiKey}`;
  if (typeof inboundAuthorization === "string" && inboundAuthorization.trim()) {
    return inboundAuthorization;
  }
  return undefined;
}

function headersFrom(resp: Response): Record<string, string> {
  return Object.fromEntries(resp.headers.entries());
}

async function requestJsonText(params: {
  upstream: HostGatewayUpstreamConfig;
  payload: unknown;
  inboundAuthorization?: string;
}): Promise<Response> {
  const authorization = resolveAuthorization(params.upstream, params.inboundAuthorization);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (authorization) headers.authorization = authorization;
  return fetch(trimTrailingSlash(params.upstream.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(params.payload),
  });
}

export async function forwardGatewayJsonRequest(params: {
  upstream: HostGatewayUpstreamConfig;
  payload: unknown;
  inboundAuthorization?: string;
}): Promise<HostGatewayHttpResponse> {
  const resp = await requestJsonText(params);
  return {
    status: resp.status,
    headers: headersFrom(resp),
    text: await resp.text(),
  };
}

export async function forwardGatewayJsonStreamRequest(params: {
  upstream: HostGatewayUpstreamConfig;
  payload: unknown;
  inboundAuthorization?: string;
}): Promise<HostGatewayStreamResponse> {
  const resp = await requestJsonText(params);
  return {
    status: resp.status,
    headers: headersFrom(resp),
    stream: resp.body ? Readable.fromWeb(resp.body as any) : Readable.from([""]),
  };
}

export function createDefaultGatewayForwarder(): HostGatewayForwarder {
  return {
    request: forwardGatewayJsonRequest,
    requestStream: forwardGatewayJsonStreamRequest,
  };
}
