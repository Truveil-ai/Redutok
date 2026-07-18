# Running the redutok CLI

The CLI lives in the @redutok/meter package with bin names redutok and rtk.
Build first: pnpm install and pnpm -r build from the repo root.

Three ways to invoke it:

1. pnpm exec, from the repo root. The root workspace depends on
   @redutok/meter, so pnpm links the bin into node_modules/.bin:

       pnpm exec redutok --help
       pnpm exec redutok report --last

2. Root script, also from the repo root:

       pnpm redutok --help
       pnpm redutok status

3. Global link, to get a plain redutok on PATH everywhere:

       cd packages/meter
       pnpm link --global
       redutok --help

   The real package name is @redutok/meter; pnpm link --global registers its
   redutok and rtk bins. Windows note: pnpm creates .CMD shims in the pnpm
   global bin directory. Run pnpm setup once if that directory is not on
   PATH yet, then reopen the terminal. No admin rights are needed; the shims
   live under the user profile, not Program Files.
