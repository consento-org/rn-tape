#!/usr/bin/env node
const wd = require('wd')
const { logExec, exec } = require('./lib/exec.js')
const del = require('del')
const path = require('path')
const ngrok = require('ngrok')
const { fetch, Headers } = require('cross-fetch')
const FormData = require('form-data')
const { createServer } = require('http')
const { createReadStream } = require('fs')
const { writeFile, readFile, unlink } = require('fs').promises
const yargs = require('yargs')
const mkdirp = require('mkdirp')

const DEFAULT_TIMEOUT = 90
const MAX_IDLE = 300
// Ping every couple of minutes to keep the session alive
const PING_INTERVAL = 2 * 60 * 1000

yargs.command('run <system> [location] [test]', 'Run your package\'s tests in react-natives', (args) => {
  args
    .positional('system', {
      describe: 'The system you want to run the tests on',
      choices: ['android', 'ios', 'expo']
    })
    .positional('location', {
      describe: 'The path to the package you wish to test',
      default: process.cwd()
    })
    .positional('test', {
      describe: 'A relative path within your package to its test entry point',
      default: '/test'
    })
    .option('accessKey', {
      describe: 'Your bowserstack access key if you plan on using Browserstack',
      default: process.env.BROWSERSTACK_ACCESS_KEY
    })
    .option('user', {
      describe: 'Your browserstack username if you plan on using Browserstack. Specifying this will eanble testing with Browserstack',
      default: process.env.BROWSERSTACK_USER
    })
    .option('device', {
      describe: 'The device you wish you run Browserstack tests on',
      default: process.env.BROWSERSTACK_DEVICE
    })
    .option('osVersion', {
      describe: 'The OS Version for the device you wish to run Browserstack tests on',
      default: process.env.BROWSERSTACK_OS_VERSION
    })
    .option('idleTimeout', {
      describe: 'The timeout for browserstack to end the session if the test goes idle.',
      default: process.env.BROWSERSTACK_IDLE_TIMEOUT || DEFAULT_TIMEOUT
    })
    .option('verbose', {
      describe: 'Whether to log additional logs from different processes'
    })
}, async ({
  location,
  test,
  system,
  accessKey,
  user,
  device,
  osVersion,
  idleTimeout,
  verbose
}) => {
  const packageLocation = path.resolve(process.cwd(), location)
  const packageJSONLocation = path.join(packageLocation, 'package.json')
  const packageRaw = await readFile(packageJSONLocation, 'utf8')
  const packageJSON = JSON.parse(packageRaw)

  try {
    const bs = {
      user: user,
      key: accessKey
    }
    const browserStack = bs.user !== undefined
    const android = system === 'android'
    const ios = system === 'ios'
    const expo = system === 'expo'

    if (!android && !ios && !expo) {
      throw new Error('First argument needs to be "ios" or "android" or "expo"')
    }

    const runId = process.env.GITHUB_RUN_ID || 'dirty'

    if (!device) {
      if (!ios) {
        device = 'Google Pixel 3'
      } else {
        device = 'iPhone XS'
      }
    }

    if (!osVersion) {
      if (!ios) {
        osVersion = '9.0'
      } else {
        osVersion = '12'
      }
    }

    const build = `${runId}:react-native:${system}:${device}:${osVersion}`
    console.log(`## Running ${browserStack ? 'browser-stack' : 'local'} build → ${build}`)

    // This will be used to wait for results to come in at the very end
    let _resolve
    let _reject
    const response = new Promise((resolve, reject) => {
      _resolve = resolve
      _reject = reject
    })

    // This is where we copy over the project to be a dependency of our compiled app
    const root = path.join(__dirname, expo ? 'expotape' : 'rntape')
    const target = path.join(root, 'node_modules', packageJSON.name)
    try {
      // We should delete it if it already exists.
      // Force:true is needed in case we rn-tape is installed globally
      await del(target, { force: true })
      console.log(`## react-native:clearing-old-dep [target=${target}]`)
    } catch (err) {
      if (err.code !== 'ENOTDIR') {
        throw err
      }
    }

    console.log('## react-native:npm install')

    // Add the raw package.json template
    const rnPkg = require(`${root}/template-package.json`)
    await writeFile(`${root}/package.json`, JSON.stringify(rnPkg, null, 2) + '\n')

    // Install any dependencies of the wrapper app
    await logExec('npm', ['i'], { cwd: root, quiet: !verbose })

    console.log('## react-native:npm pack')

    // Pack up package
    await logExec('npm', ['pack'], {
      cwd: packageLocation,
      quiet: !verbose
    })

    // Get a reference to the tar file
    const tarName = `${packageJSON.name}-${packageJSON.version}.tgz`
    const tarPath = path.join(packageLocation, tarName)

    try {
      console.log('## react-native:npm install .tgz')

      // Install from pack file
      await logExec('npm', ['i', tarPath], {
        cwd: root, quiet: !verbose
      })
    } finally {
    // Delete pack file
      await unlink(tarPath)
    }

    console.log('## react-native:npm install sub-dependencies')

    // Merge devDependencies with dependencies
    const { dependencies = {}, devDependencies = {} } = packageJSON
    const combinedDeps = { ...dependencies, ...devDependencies }

    // We shouldn't install ourselves
    delete combinedDeps['rn-tape']

    // List all depnendencies of the project so we can install them at the top level
    const toInstall = Object.keys(combinedDeps).map((name) => {
      const version = combinedDeps[name]
      return `${name}@${version}`
    })

    // Install dependencies at the top level
    // This needs to be done for react-native linking to work correctly
    // Also needs to be done so that any dev dependencies get installed for running tests
    await logExec('npm', ['i'].concat(toInstall), {
      cwd: root, quiet: !verbose
    })

    // Start up the local server that will be used to collect logs
    // Logs will be sent in a single HTTP request
    console.log('## local-server:start')
    const { server, close } = await createServerAsync((req, res) => {
      // Collect test result data
      const result = []
      req.on('data', data => result.push(data))
      req.on('error', (error) => {
        console.error(error)
        res.end('fail')
      })
      // Once the request data has finished, parse it as JSON and resolve the output
      req.on('end', () => {
        res.end('ok')
        try {
          const parsed = JSON.parse(Buffer.concat(result).toString('utf8'))
          _resolve(parsed)
        } catch (e) {
          _reject(e)
        }
      })
    }, 1234)

    let driver

    try {
      // Start an NGROK tunnel for our log collecting server
      console.log('## ngrok:connect')
      const publicURL = await ngrok.connect({
        proto: 'http',
        region: process.env.NGROK_REGION,
        addr: server.address().port
      })
      console.log(`## ngrok:connected [publicURL=${publicURL}]`)

      // We will generate a JS file which will contain test info
      // It will export a function to run the package's tests
      // And it will export the public URL of the NGROK server to send logs to
      console.log('## react-native:build:prepare')
      await writeFile(
      `${root}/test-config.js`,
      `// This file was generated by rn-tape
        function runTest () {
          require('${packageJSON.name}${test}')
        }

        const publicURL = ${JSON.stringify(publicURL)}

        module.exports = {runTest, publicURL}
      `
      )

      let buildDetails

      // If we're running on Android, build the APK for it
      if (android) {
        console.log('## react-native:build:android')
        await logExec('./gradlew', ['assembleRelease'], { cwd: `${root}/android`, quiet: !verbose })
        buildDetails = {
          app: `${root}/android/app/build/outputs/apk/release/app-release.apk`,
          capabilities: {
            device,
            os_version: osVersion
          }
        }
      }

      // If we're running on expo, build the XDL bundle
      if (expo) {
        console.log('## react-native:build:expo')
        const build = await parseExpoBuild('npx', ['expo', 'build:android', '-t', 'app-bundle', '--non-interactive'], { cwd: root })
        console.log({ build })
        const app = (await exec('node', ['-e', `
        const xdl = require('@expo/xdl');
        xdl.Project.getBuildStatusAsync(
          '.',
          { platform: 'android', current: false }
        ).then(data => {
            if(!data.jobs) return
            const results = data.jobs.filter(job => job.id === '${build}')
            if(!results.length) return
            console.log(
              results[0].artifacts.url
            )
        })
      `], { cwd: root }).promise()).trim()
        if (verbose) console.log({ app })
        buildDetails = {
          appUrl: app,
          capabilities: {
            device,
            os_version: osVersion
          }
        }
      }

      if (ios) {
        console.log('## react-native:build:ios:pod')
        await logExec('pod', ['install', '--clean-install'], { cwd: `${root}/ios`, quiet: !verbose })
        console.log('## react-native:build:ios:app')
        await mkdirp(`${root}/ios/build`)
        await logExec(
          'xcodebuild',
          [
            'clean',
            'build',
            '-workspace', `${root}/ios/rntape.xcworkspace`,
            '-configuration', 'Release',
            '-scheme', 'rntape',
            '-arch', 'arm64',
            '-derivedDataPath', 'build',
            'CODE_SIGN_IDENTITY=""',
            'CODE_SIGNING_REQUIRED="NO"',
            'CODE_SIGN_ENTITLEMENTS=""',
            'CODE_SIGNING_ALLOWED="NO"'
          ],
          { cwd: `${root}/ios`, quiet: !verbose }
        )
        console.log('## react-native:build:ios:ipa')
        await logExec('rm', ['-rf', 'ipa'], { cwd: `${root}/ios/build`, quiet: !verbose })
        await mkdirp(`${root}/ios/build/ipa/Payload`)
        await logExec('cp', ['-r', 'build/Build/Products/Release-iphoneos/rntape.app', 'build/ipa/Payload/rntape.app'], { cwd: `${root}/ios`, quiet: !verbose })
        await logExec('rm', ['-f', 'rntape-1.ipa'], { cwd: `${root}/ios/build`, quiet: !verbose })
        await logExec('zip', ['-r', '../rntape-1.ipa', 'Payload'], { cwd: `${root}/ios/build/ipa`, quiet: !verbose })
        buildDetails = {
          app: `${root}/ios/build/rntape-1.ipa`,
          capabilities: {
            device,
            os_version: osVersion
          }
        }
      }

      if (browserStack) {
        const formData = new FormData()
        if (buildDetails.app) {
          formData.append('file', createReadStream(buildDetails.app))
          formData.append('data', '{}')
        } else {
          formData.append('data', JSON.stringify({ url: buildDetails.appUrl }))
        }
        const headers = new Headers(formData.getHeaders())
        headers.append('Authorization', 'Basic ' + Buffer.from(bs.user + ':' + bs.key).toString('base64'))
        console.log('## Uploading file to browserstack')
        const json = await (await fetch('https://api-cloud.browserstack.com/app-automate/upload', {
          method: 'post',
          body: formData,
          headers
        })).json()

        if (json.error) {
          throw new Error(json.error)
        }

        const { app_url: appURL } = json

        console.log(`## Starting browser test at ${appURL}`)

        driver = wd.promiseRemote('http://hub-cloud.browserstack.com/wd/hub')

        const caps = {
          ...buildDetails.capabilities,
          'browserstack.user': bs.user,
          'browserstack.key': bs.key,
          'browserstack.networkLogs': true,
          // There's a max idle time in browserstack, so we shouldn't exceed it
          'browserstack.idleTimeout': Math.min(idleTimeout || 1, MAX_IDLE),
          project: packageJSON.name,
          build,
          name: packageJSON.name,
          app: appURL
        }

        if (verbose) console.log({ caps })

        process.on('uncaughtException', _reject)
        driver
          .init(caps)
          .fin(function () {})
          .done()

        if (idleTimeout >= MAX_IDLE) {
          var idlePinger = setInterval(() => {
            driver.executeScript('console.log("# Idle Ping")')
          }, PING_INTERVAL)
        }
      } else {
        if (android) {
          console.log('## react-native:install')
          await logExec('adb', ['install', '-r', 'app/build/outputs/apk/release/app-release.apk'], { cwd: `${root}/android`, quiet: !verbose })
          console.log('## MANUAL ACTION REQUIRED: open the react-native app "rntape" on the device.')
        } else {
          console.log('## MANUAL ACTION REQUIRED: Install the app and start it')
        }
      // TODO ios & expo local install
      }
      // TODO use ./rntape/android/app/build/android-sourcemap.js for good error messages
      console.log((await response).output)
    } catch (err) {
      if (err.data) {
        err.message = err.message + '\n' + err.data
      }
      throw err
    } finally {
      if (idlePinger) {
        clearInterval(idlePinger)
      }
      process.removeListener('uncaughtException', _reject)
      console.log('## driver:quit')
      await driver && driver.quit()
      console.log('## ngrok:disconnect')
      await ngrok.disconnect()
      await ngrok.kill()
      console.log('## server:close')
      await close()
    }

    const { finished } = await response
    process.exit(finished)
  } catch (err) {
    console.error(err.stack)
    process.exit(2)
  }
})
  .scriptName('rn-tape')
  .help()
  .demandCommand(1, 'Please specify a command to run')
  .parse()

async function parseExpoBuild (command, args, opts) {
  let build
  for await (const line of exec(command, args, opts)) {
    const parts = /builds\/([0-9a-f-]+)/ig.exec(line)
    if (parts) {
      build = parts[1]
    }
    console.log(line)
  }
  return build
}

function createServerAsync (listener, port) {
  return new Promise((resolve, reject) => {
    const server = createServer(listener)
    const close = () => {
      return new Promise((resolve) => {
        server.once('close', resolve)
        server.close()
      })
    }
    const finish = (error) => {
      server.removeListener('error', finish)
      server.removeListener('listening', finish)
      if (error instanceof Error) {
        reject(error)
      } else {
        resolve({ server, close })
      }
    }
    server.once('error', finish)
    server.once('listening', finish)
    server.listen(port)
  })
}
