export interface LinkedUpSimulationModule {
  ccall(
    name: string,
    returnType: "number" | null,
    argumentTypes: readonly string[],
    arguments_: readonly (string | number)[],
  ): number;
  UTF8ToString(pointer: number): string;
}

export interface LinkedUpSimulationOptions {
  locateFile?(path: string): string;
}

export default function createLinkedUpSimulation(
  options?: LinkedUpSimulationOptions,
): Promise<LinkedUpSimulationModule>;
