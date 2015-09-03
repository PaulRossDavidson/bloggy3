BloggyApp.controller('PostNewCtrl', ['$scope','Post', '$location', function($scope, Post, $location){

  $scope.newPost={
    title:'',
    body:''
  };

  $scope.createPost = function(){
    var newPost = new Post($scope.newPost);
    newPost.$save().then(function(postResult){
      console.log('post',postResult);
      $location.path('/');
    }).catch(function(err){
      console.log('err',err);
    });
  }

  console.log("PostNewCtrl working");

}]);
