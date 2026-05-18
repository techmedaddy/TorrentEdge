pipeline {
  agent any

  options {
    timestamps()
    ansiColor('xterm')
  }

  tools {
    nodejs 'node-20'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Install dependencies') {
      steps {
        sh 'npm ci'
      }
    }

    stage('Run tests') {
      steps {
        sh 'npm test'
      }
    }
  }

  post {
    always {
      archiveArtifacts artifacts: 'coverage/**', allowEmptyArchive: true
    }
  }
}
