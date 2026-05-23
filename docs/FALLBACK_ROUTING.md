# Fallback routing

RouteScore can now produce and execute ordered fallback plans. This prevents an agent from depending on a single paid API when multiple acceptable services exist.

## CLI route plan

```bash
mythos-sentinel routescore route --category web_search --max-price 0.05
```

The plan includes:

1. selected service
2. fallback services
3. RouteScore and price
4. Sentinel payment-policy decisions

## CLI fallback simulation

```bash
mythos-sentinel routescore fallback --category web_search --max-price 0.05 --simulate-fail primary
```

This does not call paid APIs. It demonstrates the attempt order and fallback behavior using a simulated executor.

## SDK primitive

`executeFallbackRoute` accepts a route plan and a caller-provided executor:

```js
const result = await executeFallbackRoute({
  plan,
  executor: async (service) => callProvider(service.endpoint)
});
```

Sentinel does not hide spending logic inside fallback routing. Integrations remain responsible for payment/signing flows, while Sentinel supplies route order, policy checks, and telemetry hooks.
