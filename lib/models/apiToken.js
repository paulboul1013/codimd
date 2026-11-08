'use strict'
// external modules
var Sequelize = require('sequelize')

module.exports = function (sequelize, DataTypes) {
  var ApiToken = sequelize.define('ApiToken', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: Sequelize.UUIDV4
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    tokenHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true
    },
    prefix: {
      type: DataTypes.STRING(16),
      allowNull: false
    },
    lastUsedAt: {
      type: DataTypes.DATE
    }
  }, {
    indexes: [{ fields: ['userId'] }]
  })

  ApiToken.associate = function (models) {
    ApiToken.belongsTo(models.User, {
      foreignKey: 'userId',
      as: 'user',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    })
  }

  return ApiToken
}
