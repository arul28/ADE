const reactDevtoolsStub = {
  connectToDevTools(): void {
    // ADE's packaged TUI does not ship React DevTools.
  },
};

export default reactDevtoolsStub;
