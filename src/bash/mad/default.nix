{ pkgs ? import <nixpkgs> {} }:

pkgs.writeShellScriptBin "mad" ''
  #!${pkgs.bash}/bin/bash
  [[script]]
''