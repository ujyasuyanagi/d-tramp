pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    timeout(time: 30, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '10', artifactNumToKeepStr: '10'))
  }

  environment {
    COMPOSE_PROJECT = 'dtramp-ci'
    // Отдельные host-порты: рабочий стек d-tramp и его Mongo volume не затрагиваются.
    MONGO_HOST_PORT = '27018'
    USER_HOST_PORT = '4101'
    TRIP_HOST_PORT = '4102'
    MAP_HOST_PORT = '4103'
    GATEWAY_HOST_PORT = '4100'
    WEB_HOST_PORT = '8180'
    OSRM_HOST_PORT = '5102'
    // OSRM в CI не запускается: osrm-data нет в checkout. Пустая строка включает режим off.
    OSRM_URL = ''
    JWT_SECRET = 'ci-only-secret'
    MAP_SEED = '42'
  }

  stages {
    stage('Install') {
      steps {
        sh '''
          set -e
          mkdir -p ci-artifacts
          npm ci --include=dev --no-audit --no-fund > ci-artifacts/npm-ci.log 2>&1
          tail -n 5 ci-artifacts/npm-ci.log
        '''
      }
    }

    stage('Typecheck') {
      steps {
        sh '''
          set -e
          npm run typecheck > ci-artifacts/typecheck.log 2>&1
          cat ci-artifacts/typecheck.log
        '''
      }
    }

    stage('Build images') {
      steps {
        sh '''
          set -e
          docker compose -p dtramp-ci build user-service trip-service map-service api-gateway web \
            > ci-artifacts/build.log 2>&1
          tail -n 20 ci-artifacts/build.log
        '''
      }
    }

    stage('Start isolated stack') {
      steps {
        sh '''
          set -e
          docker compose -p dtramp-ci up -d --wait --wait-timeout 180 \
            mongo user-service trip-service map-service api-gateway
        '''
      }
    }

    stage('Smoke') {
      steps {
        sh '''
          set +e
          docker compose -p dtramp-ci exec -T \
            -e GATEWAY_URL=http://localhost:4000/graphql \
            -e OSRM_PUBLIC_URL=http://127.0.0.1:1 \
            api-gateway node scripts/smoke.mjs > ci-artifacts/smoke.log 2>&1
          status=$?
          cat ci-artifacts/smoke.log
          exit $status
        '''
      }
    }
  }

  post {
    always {
      sh(returnStatus: true, script: '''
        mkdir -p ci-artifacts
        docker compose -p dtramp-ci ps -a > ci-artifacts/compose-ps.log 2>&1
        docker compose -p dtramp-ci logs --no-color --timestamps > ci-artifacts/compose.log 2>&1
        docker compose -p dtramp-ci down -v --remove-orphans > ci-artifacts/compose-down.log 2>&1
        exit 0
      ''')
      archiveArtifacts artifacts: 'ci-artifacts/**', allowEmptyArchive: true
    }
    failure {
      echo 'CI failed: смотри ci-artifacts/typecheck.log, smoke.log и compose.log'
    }
  }
}
