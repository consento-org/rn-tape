# rn-tape
_Like airtap but with support for react-native/expo_

## Usage

```
npm i -g rn-tape

rn-tape run android ./

rn-tape --help run

rn-tape run <system> [location] [test]

Run your package's tests in react-natives

Positionals:
  location  The path to the package you wish to test
                                                                 [default: "./"]
  test      A relative path within your package to its test entry point
                                                              [default: "/test"]
  system    The system you want to run the tests on
                                  [required] [choices: "android", "ios", "expo"]

Options:
  --version    Show version number                                     [boolean]
  --help       Show help                                               [boolean]
  --accessKey  Your bowserstack access key if you plan on using Browserstack
  --user       Your browserstack username if you plan on using Browserstack.
               Specifying this will eanble testing with Browserstack
  --device     The device you wish you run Browserstack tests on
  --osVersion  The OS Version for the device you wish to run Browserstack tests
               on
```

## About

:wave: Hi! so we have been working on testing react-native libraries (specifically native ones) - actual - devices in a Continuous integration context. In other words: Automatically test every push to github if it works on all devices.

If you look at react-native libraries out there you might notice that most of them do not include CI tests _(its rare to see any)_ but more importantly most of the non-react-native libraries _(general npm libraries)_ are not tested for react-native. Which breaks quite a few and makes the setup process really stressful.

As a proof-of-concept we added the kind of tests to illustrate what we want to get working in [get-random-values-poly-pony](https://github.com/consento-org/get-random-values-polypony/actions/runs/156910073) - The tests of that project run on Node.js, on browsers via [browserstack](https://www.browserstack.com/) and on react-native android/ios (also via browserstack), and on expo _(also via browserstack)_.

This was hard work! And to make sure that this hard work doesn't need to be done by many other people, we want to make it easier for other people to get the same setup up-and-running.

**Why is it a challenge?** Existing javascript test solutions assume a immutable environment (without custom native code). But react-native allows to modify the javascript environment (native modules). In order to test react-native/expo modules on devices an actual app needs to be prepared and built to be installed on the device, which is not supported by any test framework we have seen.

Now **we are looking for people that help us**, make this more general for everyone, something like [airtap](https://github.com/airtap/airtap) with additional support for react-native.

We are looking for people to:
- check the code
- write documentation / logo / add it to books
- use it in their library
- send pull requests to existing react-native libraries (like [native-udp](https://github.com/tradle/react-native-udp) or [native-tcp](https://github.com/aprock/react-native-tcp))

We will be working on this repository in the next weeks: Ask questions [using issues](https://github.com/consento-org/rn-tape/issues/new)

_Note: As far as unit-test frameworks are concerned: many node/javascript libraries use [tape](https://github.com/substack/tape) (particularly in the dat community). But tape does not work out-of-the-box with react-native, which is why Martin is maintaining a slightly fixed fork of tape that works with react-native: [fresh-tape](https://github.com/martinheidegger/fresh-tape)._

## How it Works

- This repo contains a React-Native project which runs your test code
- The CLI will compile your code with babel and put it in a temporary folder
- Your code will be set up as a dependency of this project.
- The project is then compiled with react-native to generate an IPA or APK
- Before compiling, the CLI will start an HTTP server which will be connected to via [NGROK](https://ngrok.com/)
- Logs from the app will be sent to the HTTP server, and will be displayed in the CLI
- It will then either run the app in browserstack or locally
- For browserstack support, you'll need to add the `BROWSERSTACK_USER` and `BROWSERSTACK_ACCESS_KEY` environment variables, or use the `--user` and `--accessKey` CLI options.
- Once the app has finished sending all the data over, everything will be closed.
