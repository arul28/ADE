export function isSourceCheckoutRuntimeModule(modulePath: string): boolean {
  return /(?:^|[/\\])apps[/\\](?:ade-cli|desktop)[/\\](?:src|dist)[/\\]/i.test(
    modulePath,
  );
}
