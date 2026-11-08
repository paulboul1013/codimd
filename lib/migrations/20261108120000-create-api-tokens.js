'use strict'

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('ApiTokens', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      name: {
        type: Sequelize.STRING(100),
        allowNull: false
      },
      tokenHash: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true
      },
      prefix: {
        type: Sequelize.STRING(16),
        allowNull: false
      },
      lastUsedAt: Sequelize.DATE,
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false
      }
    })
    await queryInterface.addIndex('ApiTokens', ['userId'])
  },

  down: (queryInterface, Sequelize) => {
    return queryInterface.dropTable('ApiTokens')
  }
}
